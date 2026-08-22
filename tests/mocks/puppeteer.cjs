function realRendererOnly() {
  throw new Error('Puppeteer must be exercised through npm run test:renderer');
}

module.exports = {
  executablePath: realRendererOnly,
  launch: realRendererOnly,
};
