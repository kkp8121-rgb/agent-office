// The effects areas and the server events they may listen to. app.mjs starts every area once and relays every server event to ctx.onServer.
// Later packages add one import line and one entry each (nothing else in this file changes).
import { init as initFxWeather } from './fx-weather.mjs';
import { init as initFxChars } from './fx-chars.mjs';
import { init as initFxEvents } from './fx-events.mjs';
import { init as initFxLed } from './fx-led.mjs';
import { init as initFxHit } from './fx-hit.mjs';
import { init as initOfficeLife } from './officelife.mjs';
import { init as initIncidents } from './fx-incidents.mjs';
import { init as initFxHandoff } from './fx-handoff.mjs';
import { initCost } from './lobby.mjs';
import { init as initFxConflict } from './fx-conflict.mjs';
import { init as initFxActor } from './fx-actor.mjs';
import { init as initFxCommute } from './fx-commute.mjs';

export const AREAS = [
  { name: 'fx-weather', init: initFxWeather },
  { name: 'fx-chars', init: initFxChars },
  { name: 'fx-events', init: initFxEvents },
  { name: 'fx-led', init: initFxLed },
  { name: 'fx-hit', init: initFxHit },
  { name: 'officelife', init: initOfficeLife },
  { name: 'incidents', init: initIncidents },
  { name: 'fx-handoff', init: initFxHandoff },
  { name: 'cost', init: initCost },
  { name: 'fx-conflict', init: initFxConflict },
  { name: 'fx-actor', init: initFxActor },
  { name: 'fx-commute', init: initFxCommute },
];

/** SSE event names, besides state/log/phase/fail/weather/sysload, that connect() relays to ctx.onServer. */
export const SERVER_EVENTS = ['bell', 'compact', 'handoff', 'conflict', 'cost'];
