// Render wipes ~/.cache between build and runtime on the free tier.
// Persist Puppeteer's Chrome download inside the project directory instead —
// /opt/render/project/src/.cache/puppeteer survives across deploys and is
// visible at runtime.
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
