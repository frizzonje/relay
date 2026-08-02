// Реализация WebRTC (RTCPeerConnection) в Rust для Linux.
//
// Системный WebKitGTK в дистрибутивах Linux собран без WebRTC
// (-DENABLE_WEB_RTC=OFF) — RTCPeerConnection в JS попросту нет. Поэтому весь
// стек (SDP/ICE/DTLS/Opus) реализуем здесь через webrtc-rs, а в webview
// подменяем RTCPeerConnection полифилом (см. native_audio_shim.rs).

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Emitter};
    use tokio::sync::Mutex;

    use webrtc::api::interceptor_registry::register_default_interceptors;
    use webrtc::api::media_engine::MediaEngine;
    use webrtc::api::APIBuilder;
    use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
    use webrtc::ice_transport::ice_server::RTCIceServer;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
    use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
    use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
    use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
    use webrtc::peer_connection::RTCPeerConnection;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
    use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

    // ── Wire-форматы для IPC с JS-полифилом ─────────────────────────────────

    #[derive(Deserialize)]
    pub struct CreatePayload {
        #[serde(rename = "pcId")]
        pub pc_id: String,
        #[serde(rename = "iceServers")]
        pub ice_servers: Vec<IceServerPayload>,
        #[serde(rename = "iceTransportPolicy")]
        pub ice_transport_policy: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct IceServerPayload {
        pub urls: Vec<String>,
        pub username: Option<String>,
        pub credential: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct SdpPayload {
        #[serde(rename = "pcId")]
        pub pc_id: String,
        #[serde(rename = "type")]
        pub sdp_type: Option<String>,
        pub sdp: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct IceCandidatePayload {
        #[serde(rename = "pcId")]
        pub pc_id: String,
        pub candidate: Option<String>,
        #[serde(rename = "sdpMid")]
        pub sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        pub sdp_mline_index: Option<u16>,
    }

    #[derive(Deserialize)]
    pub struct PcIdPayload {
        #[serde(rename = "pcId")]
        pub pc_id: String,
    }

    #[derive(Serialize, Clone)]
    struct SdpReadyPayload {
        #[serde(rename = "pcId")]
        pc_id: String,
        #[serde(rename = "type")]
        sdp_type: String,
        sdp: String,
    }

    #[derive(Serialize, Clone)]
    struct IceCandidateEventPayload {
        #[serde(rename = "pcId")]
        pc_id: String,
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: String,
        #[serde(rename = "sdpMLineIndex")]
        sdp_mline_index: u16,
    }

    type PcMap = HashMap<String, Arc<RTCPeerConnection>>;
    static CONNECTIONS: Mutex<Option<PcMap>> = Mutex::const_new(None);

    async fn with_map<F, R>(f: F) -> Option<R>
    where
        F: FnOnce(&mut PcMap) -> Option<R>,
    {
        let mut guard = CONNECTIONS.lock().await;
        let map = guard.get_or_insert_with(HashMap::new);
        f(map)
    }

    fn build_api() -> webrtc::api::API {
        let mut m = MediaEngine::default();
        m.register_default_codecs().ok();
        let registry = register_default_interceptors(webrtc::interceptor::registry::Registry::new(), &mut m)
            .unwrap();
        APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .build()
    }

    fn ice_servers(raw: &[IceServerPayload]) -> Vec<RTCIceServer> {
        raw.iter()
            .map(|s| RTCIceServer {
                urls: s.urls.clone(),
                username: s.username.clone().unwrap_or_default(),
                credential: s.credential.clone().unwrap_or_default(),
                credential_type: webrtc::ice_transport::ice_credential_type::RTCIceCredentialType::Unspecified,
            })
            .collect()
    }

    fn opus_codec() -> RTCRtpCodecCapability {
        RTCRtpCodecCapability {
            mime_type: webrtc::api::media_engine::MIME_TYPE_OPUS.to_owned(),
            clock_rate: 48000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
            rtcp_feedback: vec![],
        }
    }

    // ── Публичный API (вызывается из main.rs) ──────────────────────────────

    pub async fn create_peer(app: AppHandle, payload: CreatePayload) {
        let api = build_api();
        let config = RTCConfiguration {
            ice_servers: ice_servers(&payload.ice_servers),
            ice_transport_policy: match payload.ice_transport_policy.as_deref() {
                Some("relay") => RTCIceTransportPolicy::Relay,
                _ => RTCIceTransportPolicy::All,
            },
            ..Default::default()
        };

        let pc = match api.new_peer_connection(config).await {
            Ok(pc) => Arc::new(pc),
            Err(e) => {
                eprintln!("[webrtc] create failed for {}: {e}", payload.pc_id);
                return;
            }
        };

        let pc_id_ice = payload.pc_id.clone();
        let app_ice = app.clone();
        pc.on_ice_candidate(Box::new(
            move |candidate: Option<RTCIceCandidate>| {
                if let Some(c) = candidate {
                    if let Ok(init) = c.to_json() {
                        let payload = IceCandidateEventPayload {
                            pc_id: pc_id_ice.clone(),
                            candidate: init.candidate,
                            sdp_mid: init.sdp_mid.unwrap_or_default(),
                            sdp_mline_index: init.sdp_mline_index.unwrap_or(0),
                        };
                        let _ = app_ice.emit("webrtc:ice-candidate", &payload);
                    }
                }
                Box::pin(async {})
            },
        ));

        let pc_id_st = payload.pc_id.clone();
        let app_st = app.clone();
        pc.on_peer_connection_state_change(Box::new(
            move |s: RTCPeerConnectionState| {
                let state_str = format!("{s:?}").to_lowercase();
                let _ = app_st.emit(
                    "webrtc:connection-state",
                    serde_json::json!({ "pcId": pc_id_st, "state": state_str }),
                );
                Box::pin(async {})
            },
        ));

        let pc_id_tr = payload.pc_id.clone();
        let app_tr = app.clone();
        pc.on_track(Box::new(
            move |track: Arc<webrtc::track::track_remote::TrackRemote>,
                  _receiver: Arc<webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver>,
                  _transceiver: Arc<webrtc::rtp_transceiver::RTCRtpTransceiver>| {
                let kind = track.kind().to_string();
                let mid = track.id().to_string();
                let _ = app_tr.emit(
                    "webrtc:track",
                    serde_json::json!({ "pcId": pc_id_tr, "kind": kind, "mid": mid }),
                );
                Box::pin(async {})
            },
        ));

        let pc_id_nn = payload.pc_id.clone();
        let app_nn = app.clone();
        pc.on_negotiation_needed(Box::new(move || {
            let _ = app_nn.emit(
                "webrtc:negotiation-needed",
                serde_json::json!({ "pcId": pc_id_nn }),
            );
            Box::pin(async {})
        }));

        with_map(move |map| {
            map.insert(payload.pc_id, pc);
            None::<()>
        })
        .await;
    }

    pub async fn create_offer(app: AppHandle, payload: PcIdPayload) {
        let pc = with_map(|map| map.get(&payload.pc_id).cloned()).await;
        let Some(pc) = pc else { return };

        let offer = match pc.create_offer(None).await {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[webrtc] createOffer failed for {}: {e}", payload.pc_id);
                return;
            }
        };
        if let Err(e) = pc.set_local_description(offer.clone()).await {
            eprintln!("[webrtc] setLocalDescription failed for {}: {e}", payload.pc_id);
            return;
        }
        let _ = app.emit(
            "webrtc:offer-ready",
            &SdpReadyPayload {
                pc_id: payload.pc_id,
                sdp_type: "offer".into(),
                sdp: offer.sdp,
            },
        );
    }

    pub async fn create_answer(app: AppHandle, payload: PcIdPayload) {
        let pc = with_map(|map| map.get(&payload.pc_id).cloned()).await;
        let Some(pc) = pc else { return };

        let answer = match pc.create_answer(None).await {
            Ok(a) => a,
            Err(e) => {
                eprintln!("[webrtc] createAnswer failed for {}: {e}", payload.pc_id);
                return;
            }
        };
        if let Err(e) = pc.set_local_description(answer.clone()).await {
            eprintln!("[webrtc] setLocalDescription failed for {}: {e}", payload.pc_id);
            return;
        }
        let _ = app.emit(
            "webrtc:answer-ready",
            &SdpReadyPayload {
                pc_id: payload.pc_id,
                sdp_type: "answer".into(),
                sdp: answer.sdp,
            },
        );
    }

    pub async fn set_remote_description(payload: SdpPayload) {
        let pc = with_map(|map| map.get(&payload.pc_id).cloned()).await;
        let Some(pc) = pc else { return };

        let sdp_type = match payload.sdp_type.as_deref() {
            Some("offer") => RTCSdpType::Offer,
            Some("answer") => RTCSdpType::Answer,
            _ => return,
        };
        let mut sdp = RTCSessionDescription::default();
        sdp.sdp_type = sdp_type;
        sdp.sdp = payload.sdp.unwrap_or_default();
        if let Err(e) = pc.set_remote_description(sdp).await {
            eprintln!("[webrtc] setRemoteDescription failed for {}: {e}", payload.pc_id);
        }
    }

    pub async fn add_ice_candidate(payload: IceCandidatePayload) {
        let pc = with_map(|map| map.get(&payload.pc_id).cloned()).await;
        let Some(pc) = pc else { return };

        let candidate = RTCIceCandidateInit {
            candidate: payload.candidate.unwrap_or_default(),
            sdp_mid: payload.sdp_mid,
            sdp_mline_index: payload.sdp_mline_index,
            username_fragment: None,
        };
        if let Err(e) = pc.add_ice_candidate(candidate).await {
            eprintln!("[webrtc] addIceCandidate failed for {}: {e}", payload.pc_id);
        }
    }

    pub async fn add_audio_track(payload: PcIdPayload) {
        let pc = with_map(|map| map.get(&payload.pc_id).cloned()).await;
        let Some(pc) = pc else { return };

        let track = Arc::new(TrackLocalStaticSample::new(
            opus_codec(),
            format!("audio-{}", payload.pc_id),
            "audio".into(),
        ));
        if let Err(e) = pc.add_track(track).await {
            eprintln!("[webrtc] addTrack failed for {}: {e}", payload.pc_id);
        }
    }

    pub async fn close_peer(payload: PcIdPayload) {
        let pc = with_map(|map| map.remove(&payload.pc_id)).await;
        if let Some(pc) = pc {
            let _ = pc.close().await;
        }
    }
}

// На не-Linux — заглушки.
#[cfg(not(target_os = "linux"))]
mod imp {
    use tauri::AppHandle;
    #[derive(serde::Deserialize)] pub struct CreatePayload { pub pc_id: String, pub ice_servers: Vec<IceServerPayload>, pub ice_transport_policy: Option<String>, }
    #[derive(serde::Deserialize)] pub struct IceServerPayload { pub urls: Vec<String>, pub username: Option<String>, pub credential: Option<String>, }
    #[derive(serde::Deserialize)] pub struct SdpPayload { pub pc_id: String, pub sdp_type: Option<String>, pub sdp: Option<String>, }
    #[derive(serde::Deserialize)] pub struct IceCandidatePayload { pub pc_id: String, pub candidate: Option<String>, pub sdp_mid: Option<String>, pub sdp_mline_index: Option<u16>, }
    #[derive(serde::Deserialize)] pub struct PcIdPayload { pub pc_id: String, }

    pub async fn create_peer(_app: AppHandle, _payload: CreatePayload) {}
    pub async fn create_offer(_app: AppHandle, _payload: PcIdPayload) {}
    pub async fn create_answer(_app: AppHandle, _payload: PcIdPayload) {}
    pub async fn set_remote_description(_payload: SdpPayload) {}
    pub async fn add_ice_candidate(_payload: IceCandidatePayload) {}
    pub async fn add_audio_track(_payload: PcIdPayload) {}
    pub async fn close_peer(_payload: PcIdPayload) {}
}

pub use imp::*;
