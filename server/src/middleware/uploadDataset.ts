import multer, { FileFilterCallback } from 'multer';
import { Request } from 'express';
import path from 'path';
import fs from 'fs';
import { uploadConfig } from '../config/streaming';
import { BadRequestError } from '../utils/customErrors';

const destination = path.resolve(uploadConfig.dir);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }
    cb(null, destination);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${base}-${suffix}${ext}`);
  },
});

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!uploadConfig.allowedExtensions.includes(ext)) {
    return cb(
      new BadRequestError(
        `Unsupported file type "${ext}". Upload a GDF or CSV recording.`
      )
    );
  }

  cb(null, true);
};

export const uploadDataset = multer({
  storage,
  fileFilter,
  limits: { fileSize: uploadConfig.maxBytes, files: 1 },
});

export default uploadDataset;
