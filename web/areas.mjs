// The effects areas and the server events they may listen to. app.mjs starts every area once and relays every server event to ctx.onServer.
// Later packages add one import line and one entry each (nothing else in this file changes).
import { init as initFxWeather } from './fx-weather.mjs';
import { init as initFxChars } from './fx-chars.mjs';
import { init as initFxEvents } from './fx-events.mjs';
import { init as initFxLed } from './fx-led.mjs';
import { init as initFxHit } from './fx-hit.mjs';
import { init as initOfficeLife } from './officelife.mjs';
import { init as initFxActor } from './fx-actor.mjs';

export const AREAS = [
  { name: 'fx-weather', init: initFxWeather },
  { name: 'fx-chars', init: initFxChars },
  { name: 'fx-events', init: initFxEvents },
  { name: 'fx-led', init: initFxLed },
  { name: 'fx-hit', init: initFxHit },
  { name: 'officelife', init: initOfficeLife },
  { name: 'fx-actor', init: initFxActor },
];

/** SSE event names, besides state/log/phase/fail/weather/sysload, that connect() relays to ctx.onServer. */
export const SERVER_EVENTS = ['bell', 'compact', 'handoff', 'conflict', 'cost'];
