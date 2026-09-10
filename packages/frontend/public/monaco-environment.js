// Loaded before the application without requiring CSP unsafe-inline.
self.MonacoEnvironment = {
  globalAPI: false,
  getWorkerUrl(_moduleId, label) {
    const workers = {
      editorWorkerService: 'editor',
      css: 'css', less: 'css', scss: 'css',
      html: 'html', handlebars: 'html', razor: 'html',
      json: 'json',
      typescript: 'ts', javascript: 'ts',
    };
    const name = workers[label] || 'editor';
    return `/monacoeditorwork/${name}.worker.bundle.js`;
  },
};
