# Иконки приложения

Набор иконок relay (mesh-триада на тёмном скруглённом квадрате) **закоммичен** —
`cargo tauri build` работает без предварительных шагов, CI тоже.

- `icon.svg` — источник (1024×1024, знак из `apps/web/components/ui/Logo.tsx`);
- `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` (macOS),
  `icon.ico` (Windows), `icon.png` — то, что ждёт `tauri.conf.json → bundle.icon`.

## Перегенерация (если поменяли знак)

```bash
cd clients/desktop
# из PNG ≥ 1024×1024 (растеризовать icon.svg: qlmanage/rsvg-convert/resvg)
cargo tauri icon path/to/relay-logo.png
# затем убрать лишнее для десктопа (генератор кладёт и mobile/Store-плитки):
rm -rf src-tauri/icons/{android,ios,Square*Logo.png,StoreLogo.png}
```
