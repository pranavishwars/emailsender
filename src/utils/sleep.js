'use strict';

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { sleep, randomBetween };
