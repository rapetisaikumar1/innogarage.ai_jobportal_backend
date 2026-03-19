const multer = require('multer');
const path = require('path');
const config = require('../config');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    resume: ['.pdf'],
    material: ['.pdf', '.doc', '.docx', '.mp4', '.avi', '.mov', '.pptx', '.ppt'],
    avatar: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    document: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'],
  };

  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = allowedTypes[file.fieldname] || ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];

  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${ext} not allowed for ${file.fieldname}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxFileSize },
});

module.exports = upload;
