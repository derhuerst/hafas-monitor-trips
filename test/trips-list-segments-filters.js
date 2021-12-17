'use strict'

const a = require('assert')
const tripsListSegmentsFilters = require('../lib/trips-list-segments-filters')

const mockProducts = [
	{id: 'foo', bitmasks: [1, 4]},
	{id: 'bar', bitmasks: [2]},
	{id: 'baz', bitmasks: [8, 16]},
]
const mockHafas = {
	profile: {
		products: mockProducts,
	},
}

const withLine = (lineName, opName) => ({
	line: {
		name: lineName,
		operator: {name: opName},
	},
})

const lineNameOrFahrtNr0 = '*'
const opts0 = {}
const trips0 = [
	{},
	{},
	{},
	{},
]

const segments1 = tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr0, opts0, trips0)
a.deepStrictEqual(segments1, [{
	lineNameOrFahrtNr: lineNameOrFahrtNr0,
	opts: {...opts0, products: {foo:  true, bar: false, baz: false}},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr0,
	opts: {...opts0, products: {foo: false, bar:  true, baz: false}},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr0,
	opts: {...opts0, products: {foo: false, bar: false, baz:  true}},
}])

const lineNameOrFahrtNr1a = segments1[0].lineNameOrFahrtNr
const opts1a = segments1[0].opts
const trips1a = [
	withLine('line A', 'OP 1'),
	withLine('line B', 'op2'),
	withLine('line C', 'OP 1'),
	withLine('line B', 'op_3'),
]
const segments1a2 = tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr1a, opts1a, trips1a)
a.deepStrictEqual(segments1a2, [{
	lineNameOrFahrtNr: lineNameOrFahrtNr1a,
	opts: {...opts1a, operatorNames: ['OP 1']},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr1a,
	opts: {...opts1a, operatorNames: ['op2']},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr1a,
	opts: {...opts1a, operatorNames: ['op_3']},
}])

const lineNameOrFahrtNr1a2a = segments1a2[0].lineNameOrFahrtNr
const opts1a2a = segments1a2[0].opts
const trips1a2a = [
	withLine('line A', 'OP 1'),
	withLine('line C', 'OP 1'),
]
const segments1a2a3 = tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr1a2a, opts1a2a, trips1a2a)
a.deepStrictEqual(segments1a2a3, [{
	lineNameOrFahrtNr: 'line A',
	opts: opts1a2a,
}, {
	lineNameOrFahrtNr: 'line C',
	opts: opts1a2a,
}])

const lineNameOrFahrtNr1a2a3a = segments1a2a3[0].lineNameOrFahrtNr
const opts1a2a3a = segments1a2a3[0].opts
a.throws(() => tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr1a2a3a, opts1a2a3a, []))

console.info('tripsListSegmentsFilters seems to be working ✔︎')
