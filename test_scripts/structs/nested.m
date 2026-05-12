% Nested struct fields via both creation forms (dot-assign and the
% struct(...) constructor), mixed with a tensor-valued leaf.

% Dot-assign all the way down.
outer.inner.x = 3;
outer.inner.y = 4;
outer.scale = 2.0;
assert(outer.inner.x == 3, 'nested.dot.x');
assert(outer.inner.y == 4, 'nested.dot.y');
assert(outer.scale == 2.0, 'nested.dot.scale');

% Mixed: write the inner via constructor on its own; the outer via dot.
inner = struct('x', 10, 'y', 20);
outer2.inner = inner;
outer2.scale = 3.5;
assert(outer2.inner.x == 10, 'nested.mix.x');
assert(outer2.inner.y == 20, 'nested.mix.y');
assert(outer2.scale == 3.5, 'nested.mix.scale');

% Tensor leaf at the inner level (assigned via dot).
holder.data.row = [1 2 3 4];
% v1 requires hoisting before indexing through the chain.
v = holder.data.row;
assert(v(1) == 1, 'nested.tensor.v1');
assert(v(4) == 4, 'nested.tensor.v4');

disp('SUCCESS');
