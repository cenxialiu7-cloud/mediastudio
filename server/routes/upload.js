import express from 'express';
import multer from 'multer';
import path from 'path';
import { MEDIA_DIR } from '../config.js';
import { decodeFilename } from '../utils/multerName.js';

const MAX_FILES = 1024;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    file.originalname = decodeFilename(file.originalname);
    const safe = file.originalname.replace(/[\/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_').slice(0, 120);
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024 * 1024, // 8 GB per file
    files: MAX_FILES
  }
});

const router = express.Router();

// POST /api/upload  field name: "files" (one or many)
// Returns { files: [{ name, path, size }] } — caller then enqueues via /api/jobs.
router.post('/', (req, res) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return res.status(413).json({ error: `一次最多 ${MAX_FILES} 個檔案，請分批上傳` });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: '單檔超過 8 GB 上限' });
      }
      return res.status(400).json({ error: err.message || String(err) });
    }
    const files = (req.files || []).map((f) => ({
      name: f.originalname,
      path: path.join(MEDIA_DIR, f.filename),
      size: f.size
    }));
    res.json({ files });
  });
});

export default router;
