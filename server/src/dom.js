/**
 * dom.js: a DOMParser for the app's HTML code (js/data/html.js), which cleans and reads note
 * bodies. Workers have no DOM, so linkedom stands in. It only parses whole documents, so a body
 * is wrapped in one first. Import this before anything from js/data.
 */
import { DOMParser as LinkedomParser } from 'linkedom';

class BodyParser {
  parseFromString(html, type) {
    const text = String(html ?? '');
    const whole = /<html[\s>]/i.test(text) ? text : `<!doctype html><html><head></head><body>${text}</body></html>`;
    return new LinkedomParser().parseFromString(whole, type);
  }
}

globalThis.DOMParser = BodyParser;
