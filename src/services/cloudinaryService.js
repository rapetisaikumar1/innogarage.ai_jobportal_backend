require('dotenv').config();
const cloudinary = require('cloudinary').v2;

// Cloudinary auto-configures from CLOUDINARY_URL env var if present.
// Otherwise fall back to individual vars.
if (!process.env.CLOUDINARY_URL) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const cfg = cloudinary.config();
console.log('Cloudinary init:', cfg.cloud_name ? `cloud=${cfg.cloud_name} key=${cfg.api_key}` : 'NOT CONFIGURED');

/**
 * Upload a file buffer to Cloudinary
 * @param {Buffer} fileBuffer - The file buffer from multer memory storage
 * @param {Object} options - Upload options
 * @param {string} options.folder - Cloudinary folder (e.g., 'resumes', 'avatars', 'materials')
 * @param {string} options.resourceType - 'auto', 'image', 'raw' (use 'raw' for PDFs/docs)
 * @param {string} [options.publicId] - Optional custom public ID
 * @returns {Promise<{url: string, publicId: string}>}
 */
const uploadToCloudinary = (fileBuffer, options = {}) => {
  const { folder = 'uploads', resourceType = 'auto', publicId } = options;

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: `innogarage/${folder}`,
      resource_type: resourceType,
    };
    if (publicId) uploadOptions.public_id = publicId;

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    uploadStream.end(fileBuffer);
  });
};

/**
 * Upload a readable file stream to Cloudinary.
 * @param {stream.Readable} pdfStream - The readable document stream
 * @param {string} fileName - The file name
 * @returns {Promise<{url: string, publicId: string}>}
 */
const uploadStreamToCloudinary = (pdfStream, fileName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'innogarage/resumes',
        resource_type: 'raw',
        public_id: fileName,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    pdfStream.pipe(uploadStream);
  });
};

/**
 * Delete a file from Cloudinary by public ID
 * @param {string} publicId
 * @param {string} resourceType - 'image' or 'raw'
 */
const deleteFromCloudinary = async (publicId, resourceType = 'raw') => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (error) {
    console.error('Cloudinary delete error:', error.message);
  }
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
  uploadStreamToCloudinary,
  deleteFromCloudinary,
};
