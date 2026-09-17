// Entry point for the embedded Node runtime inside the Android APK.
//
// nodejs-mobile starts this file with cwd set to the extracted project folder.
// The layout mirrors the repository — server code in ./server/, the built client
// in ./client/dist — because server.js locates the client with
// path.join(__dirname, '../client/dist'). Flattening server.js to the project
// root breaks that: it would resolve outside the project and the app would
// serve 404s. Verified both ways.
//
// Everything the WebView needs is served by this process on loopback.

// Phone-sized cache. The default is 160 MB, which together with the provider
// indexes would put the process near 250 MB and invite Android to kill it.
process.env.PORT = process.env.PORT || '5000';
process.env.NODE_ENV = 'production';
process.env.AUDIO_CACHE_MB = process.env.AUDIO_CACHE_MB || '32';

// The server installs its own fatal handlers: an uncaughtException exits(1) so
// a supervisor restarts clean. Inside an APK there is no supervisor, so an exit
// would leave the WebView pointing at a dead port with no recovery. Keep the
// process alive instead and let the next request surface the problem.
process.on('uncaughtException', (e) => {
  console.error('[soundwave] uncaughtException (kept alive):', e && e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[soundwave] unhandledRejection:', e && e.message);
});

import('./server/server.js')
  .then(() => {
    console.log('[soundwave] embedded server started on port ' + process.env.PORT);
  })
  .catch((e) => {
    console.error('[soundwave] server failed to start:', e && e.message);
    // Do not exit: MainActivity polls /api/health and will show a readable
    // error after its timeout, which is more useful than a silent dead app.
  });
