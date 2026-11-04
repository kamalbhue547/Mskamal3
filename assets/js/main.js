import { startApp } from './app.js';
import { startBackdrop } from './backdrop.js';

startApp({ startBackdrop }).catch((error) => {
  // startApp reports expected failures in the UI itself; this is the last resort.
  console.error('The portfolio failed to start:', error);
});
