import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../scripts/lib/signals/csv.js';

test('parses quoted fields with commas and escaped quotes', () => {
    const rows = parseCSV('name,note\r\n"Acme, Inc.","said ""hi"""\nplain,ok\n');
    assert.deepEqual(rows, [['name', 'note'], ['Acme, Inc.', 'said "hi"'], ['plain', 'ok']]);
});
