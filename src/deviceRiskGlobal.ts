// IIFE entry of the Device risk script tag (touchque-device.global.js, served
// as device.js): starts on the page from its own script element's data-site-key,
// data-purpose and data-api, and sets window.TouchQueDevice.

import { installFromScript } from './deviceRiskTag';

installFromScript(typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null);
