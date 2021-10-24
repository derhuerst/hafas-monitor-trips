'use strict'

const TRIPS_KEY = 'v1-trips'

const createWatchedTripsSet = (redis, ttl, monitoredTripsTotal) => {
	const NS = TRIPS_KEY + '!'

	const put = async (entries) => {
		const batch = redis.pipeline()
		for (const [tripId, lineName] of entries) {
			batch.set(NS + tripId, lineName, 'PX', ttl)
		}
		await batch.exec()
	}

	const del = async (tripId) => {
		await redis.del(NS + tripId)
	}

	const entries = async function* () {
		let cursor = '0'
		let count = 0
		while (true) {
			const [
				newCursor, keys,
			] = await redis.scan(cursor, 'COUNT', 300, 'MATCH', NS + '*')
			cursor = newCursor

			const op = redis.multi()
			for (const key of keys) op.get(key)
			const res = await op.exec()
			for (let i = 0; i < res.length; i++) {
				const [err, lineName] = res[i]
				if (err) throw err // err?
				if (lineName === null) continue
				yield [
					keys[i].slice(NS.length),
					lineName,
				]
				count++
			}

			if (cursor === '0') break
		}

		// todo: this happens too rarely
		monitoredTripsTotal.set(count)
	}

	return {
		put,
		del,
		entries,
	}
}

module.exports = createWatchedTripsSet
