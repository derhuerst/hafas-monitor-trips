'use strict'

const {strictEqual, ok} = require('assert')
const {gt: greaterThan} = require('sorted-array-functions')

const createIdempotentTimedPromiseQueue = (processTask, onError, opt = {}) => {
	const {
		concurrency,
	} = {
		concurrency: 8,
		...opt,
	}

	const tasks = [] // {id, t}, ordered by t
	const taskIds = new Set() // task IDs, for efficient lookup

	// currently scheduled tasks, at most `concurrency`
	let started = true
	const scheduled = new Map() // task -> timer

	const compareTasksByT = (taskA, taskB) => taskA.t - taskB.t
	const _put = (id, t) => {
		// potentially remove old task with same ID
		if (taskIds.has(id)) {
			const prevIdx = tasks.find(t => t.id === id)
			const prevTask = tasks[prevIdx]

			// remove old task
			unschedule(prevTask)
			tasks.splice(prevIdx, 1)
			out.size--
		}

		// add new task
		const task = {id, t}
		let idx = greaterThan(tasks, task, compareTasksByT)
		if (idx === -1) {
			idx = tasks.length
			tasks.push(task)
		} else {
			tasks.splice(idx, 0, task)
		}
		out.size++
	}

	const put = (id, when, absolute = false, schedule = true) => {
		if (process.env.NODE_ENV !== 'production') {
			strictEqual(typeof id, 'string', 'id must be a string')
			ok(id, 'id must not be empty')
			strictEqual(typeof when, 'number', 'when must be a number')
			ok(when >= (absolute ? Date.now() : 0), 'when must be in the future')
		}

		const t = absolute ? when : Date.now() + when
		_put(id, t)

		if (schedule) scheduleEnough()
	}

	const unschedule = (task) => {
		if (!scheduled.has(task)) return;

		const timer = scheduled.get(task)
		clearTimeout(timer)
		scheduled.delete(task)
	}

	const scheduleEnough = () => {
		if (!started) return;

		for (let i = 0; i < tasks.length && scheduled.size < concurrency; i++) {
			const task = tasks[i]
			if (scheduled.has(task)) continue

			const ms = task.t - Date.now()
			const timer = setTimeout(runTask, ms, task)
			scheduled.set(task, timer)
		}
	}

	const runTask = async (task) => {
		const {id, t} = task
		await processTask(id, t, out.size)

		// remove timer & task
		scheduled.delete(task)
		tasks.splice(tasks.indexOf(task), 1)
		out.size--

		if (started && out.size > 0) scheduleEnough()
	}

	const start = () => {
		if (started) return;
		started = true

		scheduleEnough()
	}

	const stop = () => {
		if (!started) return;
		started = false

		for (const timer of scheduled.values()) {
			clearTimeout(timer)
		}
		scheduled.clear()
	}

	const ready = Promise.resolve() // todo

	// todo: del(id)
	// todo: clearAll()
	const out = {
		size: 0,
		put,
		start, stop,
		ready,
	}
	return out
}

module.exports = createIdempotentTimedPromiseQueue
