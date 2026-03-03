const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadBufferToR2({ key, buffer, contentType, cacheControl }) {
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: cacheControl || 'public, max-age=31536000, immutable',
  }));

  return `${process.env.R2_PUBLIC_BASE_URL}/${key}`;
}

async function deleteFromR2(key) {
  await r2.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
  }));
}

module.exports = {
  uploadBufferToR2,
  deleteFromR2,
};
