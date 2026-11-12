/**
 * Composing the panel from mixins.
 *
 * The panel is one class assembled from many plain objects, and `Object.assign`
 * is silent about the one mistake that composition invites: two mixins (or a
 * mixin and the class body) defining the same name. The later copy wins, the
 * earlier is dropped, and nothing says so -- a method quietly doing someone
 * else's job. `applyMixins` makes that a load-time error instead.
 *
 * Re-applying the very same value is not a collision: the debug tools are
 * loaded per panel instance, and a second instance installs the functions the
 * first one already put on the shared prototype.
 */

/** Copy every key of `mixins` onto `target`, throwing on a name defined twice. */
export function applyMixins(target, ...mixins) {
  for (const mixin of mixins) {
    for (const key of Object.keys(mixin)) {
      if (Object.prototype.hasOwnProperty.call(target, key) && target[key] !== mixin[key]) {
        throw new Error(`[lizaIP] mixin collision: ${key} is defined twice`);
      }
      target[key] = mixin[key];
    }
  }
  return target;
}
