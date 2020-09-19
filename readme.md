# hafas-monitor-trips

**Using a HAFAS endpoint, watch all trips in a bounding box.**

[![npm version](https://img.shields.io/npm/v/hafas-monitor-trips.svg)](https://www.npmjs.com/package/hafas-monitor-trips)
[![build status](https://api.travis-ci.org/derhuerst/hafas-monitor-trips.svg?branch=master)](https://travis-ci.org/derhuerst/hafas-monitor-trips)
![ISC-licensed](https://img.shields.io/github/license/derhuerst/hafas-monitor-trips.svg)
[![chat with me on Gitter](https://img.shields.io/badge/chat%20with%20me-on%20gitter-512e92.svg)](https://gitter.im/derhuerst)
[![support me on Patreon](https://img.shields.io/badge/support%20me-on%20patreon-fa7664.svg)](https://patreon.com/derhuerst)

`hafas-monitor-trips` will periodically refresh the list of watched trips by querying the whole bounding box. It will then refresh each watched trip individually to get up-to-date data about its stopovers.


## Installation

*Note:* `hafas-monitor-trips` needs access to [Redis](https://redis.io/). Set the `REDIS_URL` environment variable to configure access to it.

```shell
npm install hafas-monitor-trips
```


## Usage

In the following example, we'll keep things simple:

- We use [`vbb-hafas`](https://github.com/public-transport/vbb-hafas), a HAFAS client querying endpoint of the Berlin & Brandenburg public transport service (VBB).
- We monitor a small bounding box in the center of Berlin.
- We `console.log` all `stopover`s (a stopover is a vehicle stopping at a stop/station at a specific point in time) monitored.

*Note:* `hafas-monitor-trips` only works with [`hafas-client@5`](https://github.com/public-transport/hafas-client/tree/5)-compatible API clients.

```js
const createHafas = require('vbb-hafas')
const createMonitor = require('hafas-monitor-trips')

const bbox = { // Potsdamer Platz in Berlin
	north: 52.52,
	west: 13.36,
	south: 52.5,
	east: 13.39,
}

const hafas = createHafas('hafas-monitor-trips example')
const monitor = createMonitor(hafas, bbox)

monitor.on('error', err => console.error(err))
monitor.on('hafas-error', err => console.error(err))
monitor.on('stats', stats => console.error(stats))
monitor.on('stopover', stopover => console.log(stopover))
```

*Note:* With a bounding larger than a few km², there will be so many HAFAS calls made that you will likely get **rate-limited by the endpoint**. One way to handle this, instead of passing a `hafas-client` instance directly into `hafas-monitor-trips`, is to **use e.g. [`hafas-client-rpc`](https://github.com/derhuerst/hafas-client-rpc) to distribute the requests** to a pool of worker machines.

You can listen for these events:

- `error` – An error occured, e.g. a network error.
- `hafas-error` – The HAFAS endpoint rejected a request with an error.
- `stats` – Stats about the monitoring process, e.g. nr of requests sent.
- `too-many-queued` – There seem to bw too many requests queued. Pick a smaller bounding box, or increase the request speed (e.g. by using more workers as explained above).
- `trip` – Every trip that has been fetched.
- `stopover` – Each stopover of every trip that has been fetched.
- `position` – The current (estimated) position of a vehicle.


## Contributing

If you have a question or need support using `hafas-monitor-trips`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, refer to [the issues page](https://github.com/derhuerst/hafas-monitor-trips/issues).
