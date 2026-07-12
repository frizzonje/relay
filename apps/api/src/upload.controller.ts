import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { Attachment, MAX_UPLOAD_BYTES, UPLOAD_DIR, UploadsService } from './uploads';

// multer без @types — берём через require, чтобы не тянуть декларации
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { diskStorage } = require('multer');

// Расширение из исходного имени: только безопасные символы, иначе без него.
// Расширение нужно, чтобы статика отдавала картинки/аудио с верным Content-Type.
function safeExt(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : '';
}

interface MulterFile {
  filename: string;
  originalname: string;
  size: number;
  mimetype: string;
}

@Controller('api')
export class UploadController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req: unknown, file: MulterFile, cb: (e: unknown, name: string) => void) => {
          cb(null, randomBytes(12).toString('hex') + safeExt(file.originalname));
        },
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  upload(@UploadedFile() file?: MulterFile): Attachment & { id: string } {
    if (!file) throw new BadRequestException('файл не получен');
    return this.uploads.register(file);
  }
}
