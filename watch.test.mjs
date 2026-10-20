import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSecondClassSeats } from './watch.mjs';

const seat = (cls, nr, status, state) =>
  `<g id="N1-grp-1-R" data-class="${cls}" aria-selected="false" aria-label="Miejsce ${nr} klasa ${cls[0] === 's' ? 2 : 1},  okno,  ${state} , niewybrane "><image id="N1-img-1-R" class="place" x="0" y="0" width="40" height="40" xlink:href="https://img.intercity.pl/grm/${status}R.png" status="${status}"></image><text class="seatNum">${nr}</text><title class="place-title">x</title></g>`;

test('counts only free second class seats', () => {
  const svg = `<svg><g><image class="internal" status="1"></image><title>Klasa 2</title></g>${seat('second class', 15, 3, 'Niedostepne')}${seat('second class', 65, 1, 'Wolne')}${seat('first class', 11, 1, 'Wolne')}</svg>`;
  assert.deepEqual(freeSecondClassSeats(svg), [65]);
});
