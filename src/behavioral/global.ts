// IIFE entry for the <script src> use case. Building this file with
// `format: 'iife'` + `globalName: 'TouchqueBehavioral'` produces a bundle
// that sets `window.TouchqueBehavioral = { attach }`, matching the legacy
// @touchque/behavioral-widget API.

import { attachBehavioral } from './index';

export const attach = attachBehavioral;
