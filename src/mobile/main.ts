import '../styles/app.css';
import '../styles/mobile.css';
import { bootstrap } from '../bootstrap';
import { initTelemetry } from '../telemetry';
import { MobileChrome } from './MobileChrome';

const el = document.getElementById('app');
if (el) {
  initTelemetry('mobile');
  void bootstrap(el, { mobile: true, chrome: (api) => new MobileChrome(api) });
}
