# hafas-monitor-trips

**Using a HAFAS endpoint, watch all [movements/vehicles](https://github.com/public-transport/hafas-client/blob/5/docs/radar.md) in a bounding box**, and optionally their [trips](https://github.com/public-transport/hafas-client/blob/5/docs/trip.md).

[![npm version](https://img.shields.io/npm/v/hafas-monitor-trips.svg)](https://www.npmjs.com/package/hafas-monitor-trips)
[![build status](https://api.travis-ci.org/derhuerst/hafas-monitor-trips.svg?branch=master)](https://travis-ci.org/derhuerst/hafas-monitor-trips)
![ISC-licensed](https://img.shields.io/github/license/derhuerst/hafas-monitor-trips.svg)
[![support me via GitHub Sponsors](https://img.shields.io/badge/support%20me-donate-fa7664.svg)](https://github.com/sponsors/derhuerst)
[![chat with me on Twitter](https://img.shields.io/badge/chat%20with%20me-on%20Twitter-1da1f2.svg)](https://twitter.com/derhuerst)

`hafas-monitor-trips` will periodically fetch all movements/vehicles in the whole bounding box. If configured, it will then fetch each vehicle's whole trip to get up-to-date data about its stopovers.


## Installation

*Note:* `hafas-monitor-trips` needs access to [Redis](https://redis.io/). Set the `REDIS_URL` environment variable to configure access to it.

```shell
npm install hafas-monitor-trips
```


## Usage

In the following example, we'll keep things simple:

- We use [`vbb-hafas`](https://github.com/public-transport/vbb-hafas), a HAFAS client querying endpoint of the Berlin & Brandenburg public transport service (VBB).
- We monitor a small bounding box in the center of Berlin.
- We `console.log` all `positions`s (of all movements/vehicles being monitored).

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
monitor.on('position', (loc, movement) => console.log(loc, movement))
```

You can listen for these events:

- `error` – An error occured, e.g. a network error.
- `hafas-error` – The HAFAS endpoint rejected a request with an error.
- `position` – The current (estimated) position and full details of a movement/vehicle.

If you listen to `position` events, you'll receive all movements (a movement one of >0 results of a [`radar()` call](https://github.com/public-transport/hafas-client/blob/5/docs/radar.md)) which are within the bounding box right now. Each movement will not have *all* stopovers of its trip though, just the next few; If you want to access all stopovers, you need to fetch the respective trip (see below).

### fetching trips

You can configure `hafas-monitor-trips` to also fetch a movements trip, including *all* its stopovers. You can configure
- which movements/vehicles to fetch the trip for (e.g. all, or just buses starting with "1"), as well as
- when to fetch the trip (by default, right after the movement/vehicle has been fetched, see below for more details), the *trip fetching strategy*.

These additional events will be emitted:

- `trip` – Every trip that has been fetched.
- `stopover` – Each stopover of every trip that has been fetched.

#### fetching trips right away

For example, we can fetch all buses' trips, right away:

```js
const fetchTrips = require('hafas-monitor-trips/fetch-trips')
const rightAwayStrategy = require('hafas-monitor-trips/fetch-trips/right-away')

const shouldFetchTrip = movement => movement.line.product === 'bus'
fetchTrips(monitor, rightAwayStrategy(shouldFetchTrip))

monitor.on('trip', trip => console.log(trip.stopovers))
```

#### fetching important trips first

You can control the order in which the trips get fetched. For example, let's fetch the "A" line's trips first, then all other buses' trips:

```js
const fetchTrips = require('hafas-monitor-trips/fetch-trips')
const priorityBasedStrategy = require('hafas-monitor-trips/fetch-trips/priority-based')

const shouldFetchTrip = (movement) => {
	if (movement.line.product === 'bus') {
		return movement.line.name === 'A' ? 1 : 0
	}
	return null // don't fetch other products
}
fetchTrips(monitor, priorityBasedStrategy(shouldFetchTrip))
```

#### fetching trips with a delay

You can fetch the trips after a certain delay. For example, let's fetch trips after 10s, but only for movements with a delayed next stopover:

```js
const fetchTrips = require('hafas-monitor-trips/fetch-trips')
const timeBasedStrategy = require('hafas-monitor-trips/fetch-trips/time-based')

const shouldFetchTrip = (movement) => {
	const nextStopover = movement.nextStopovers[0]
	if (nextStopover && nextStopover.arrivalDelay > 0) {
		return 10 * 1000
	}
	return null // don't fetch other movements' trips
}
fetchTrips(monitor, timeBasedStrategy(shouldFetchTrip))
```

### preventing excessive requests

If you fetch *all* movements' trips, with a bounding larger than a few km², there will be so many HAFAS calls made that you will likely get **rate-limited by the HAFAS endpoint**; The amount depends on the specific endpoint. This is how you can reduce the request rate:

- Use the `shouldFetchTrip(movement)` function to restrict the number of movements/vehicles that you fetch trips of, e.g. to only the line you're interested in, or only buses.
- Instead of passing a `hafas-client` instance directly into `hafas-monitor-trips`, use [`hafas-client/throttle`](https://github.com/public-transport/hafas-client/blob/5/docs/readme.md#throttling-requests) to prevent bursts of requests. You will have to experiment with the rate until you get a balance, between not sending too many requests, and being able to monitor all relevant trips.
- Use e.g. [`hafas-client-rpc`](https://github.com/derhuerst/hafas-client-rpc) to run the requests from a pool of worker machines.


## Contributing

If you have a question or need support using `hafas-monitor-trips`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, refer to [the issues page](https://github.com/derhuerst/hafas-monitor-trips/issues).
