import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';

const API = 'https://api-gateway.intercity.pl';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Origin: 'https://ebilet.intercity.pl',
  Referer: 'https://ebilet.intercity.pl/',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const stamp = d => d.replace(/\D/g, '').slice(0, 12);

async function get(path, as = 'json') {
  const res = await fetch(API + path, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res[as]();
}

async function post(endpoint, body) {
  const res = await fetch(`${API}/server/public/endpoint/${endpoint}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ urzadzenieNr: '956', ...body }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`POST ${endpoint}/${body.metoda} -> ${res.status}`);
  const json = await res.json();
  if (json.bledy?.length) throw new Error(`${body.metoda}: ${json.bledy.map(b => b.opisy?.find(o => o.jezyk === 'EN')?.komunikat ?? b.kod).join('; ')}`);
  return json;
}

export function freeSecondClassSeats(svg) {
  const seats = [];
  for (const [, seat, body] of svg.matchAll(/<g[^>]*data-class="second class"[^>]*aria-label="Miejsce (\d+)[^"]*"[^>]*>(.*?)<\/g>/gs))
    if (/class="place"[^>]*status="1"/.test(body)) seats.push(Number(seat));
  return seats;
}

async function resolveTrain(t, stations) {
  const station = name => {
    const s = stations.find(x => x.nazwa === name);
    if (!s) throw new Error(`Unknown station "${name}". Did you mean: ${stations.filter(x => x.nazwa.toLowerCase().includes(name.toLowerCase().slice(0, 5))).map(x => x.nazwa).slice(0, 8).join(', ')}`);
    return s;
  };
  const from = station(t.from), to = station(t.to);
  const { polaczenia } = await post('Pociagi', {
    metoda: 'wyszukajPolaczenia',
    dataWyjazdu: `${t.date} 00:00:00`, dataPrzyjazdu: `${t.date} 23:59:59`,
    stacjaWyjazdu: from.kod, stacjaPrzyjazdu: to.kod,
    czasNaPrzesiadkeMin: 3, czasNaPrzesiadkeMax: 1440, liczbaPrzesiadekMax: 2,
    polaczeniaBezposrednie: 1, polaczeniaNajszybsze: 0, liczbaPolaczen: 0,
    stacjePrzez: [], kategoriePociagow: [], kodyPrzewoznikow: [], rodzajeMiejsc: [], typyMiejsc: [], braille: 0, atrybutyHandlowe: [],
  });
  const leg = polaczenia.flatMap(p => p.pociagi).find(p => p.nrPociagu === t.train);
  if (!leg) throw new Error(`Train ${t.train} not found ${t.from} -> ${t.to} on ${t.date}`);
  return {
    label: `${leg.kategoriaPociagu} ${leg.nrPociagu} ${leg.nazwaPociagu ?? ''} ${t.from} ${leg.dataWyjazdu.slice(0, 16)} -> ${t.to} ${leg.dataPrzyjazdu.slice(11, 16)}`.replace(/\s+/g, ' '),
    cat: leg.kategoriaPociagu, nr: leg.nrPociagu,
    dep: stamp(leg.dataWyjazdu), arr: stamp(leg.dataPrzyjazdu),
    fromEPA: from.kodEPA, toEPA: to.kodEPA,
    availablePath: `/grm/grm/available/${t.train}/${t.date.replace(/-/g, '')}`,
    hasSeatMap: false,
    hadFree: false,
  };
}

async function freeSeats(t) {
  const sklad = await get(`/grm/sklad/wbnet/${t.cat}/${t.nr}/${t.dep}/${t.fromEPA}/${t.arr}/${t.toEPA}`);
  const free = {};
  for (const wagon of sklad.klasa2 ?? []) {
    const svg = await get(`/grm/wagon/svg/wbnet/${t.cat}/${t.nr}/${wagon}/${sklad.wagonySchemat[wagon]}/${t.dep}/${t.arr}/${t.fromEPA}/${t.toEPA}`, 'text');
    const seats = freeSecondClassSeats(svg);
    if (seats.length) free[wagon] = seats;
    await sleep(200 + Math.random() * 300);
  }
  return free;
}

async function main() {
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'])
    if (!process.env[k]) throw new Error(`Missing env var ${k}`);
  const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: Number(process.env.SMTP_PORT ?? 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const { stacje } = await post('Aktualizacja', { metoda: 'pobierzStacje', ostatniaAktualizacjaData: '2020-01-01 00:00:00.000' });
  const trains = [];
  for (const t of config.trains) {
    trains.push(await resolveTrain(t, stacje));
    log('watching', trains.at(-1).label);
  }

  let backoff = 0;
  while (true) {
    let failed = 0;
    for (const t of trains) {
      try {
        t.hasSeatMap ||= (await get(t.availablePath)).available;
        if (!t.hasSeatMap) {
          log(t.label, '| no seat map published yet');
          continue;
        }
        const free = await freeSeats(t);
        const total = Object.values(free).flat().length;
        log(t.label, '| free 2nd class:', total, total ? JSON.stringify(free) : '');
        if (total && !t.hadFree) {
          const list = Object.entries(free).map(([w, s]) => `wagon ${w}: ${s.join(', ')}`).join('\n');
          await mailer.sendMail({
            from: process.env.SMTP_USER,
            to: process.env.MAIL_TO,
            subject: `PKP: ${total} free 2nd class seat(s) - ${t.label}`,
            text: `${t.label}\n\n${list}\n\nhttps://ebilet.intercity.pl/`,
          });
          log('email sent');
        }
        t.hadFree = total > 0;
      } catch (e) {
        failed++;
        log(t.label, '| error:', e.message);
      }
    }
    backoff = failed === trains.length ? Math.min(Math.max(backoff * 2, config.intervalSec * 1000), 300000) : 0;
    await sleep(backoff || config.intervalSec * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => { console.error(e.message); process.exit(1); });
