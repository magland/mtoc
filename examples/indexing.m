% A tour of the indexing forms mtoc supports.
% Translate to see the generated C:
%   npx tsx src/cli.ts translate examples/indexing.m
% Or run end-to-end (compile + execute):
%   npx tsx src/cli.ts run examples/indexing.m

% ── Scalar reads ─────────────────────────────────────────────────────
% Each `v(i)` lowers to one bracketed array access — `v.real[i-1]` for
% real, `(v.real[i-1] + v.imag[i-1] * I)` for complex, `v.data[i-1]`
% for char.
v = [10 20 30 40 50];
disp(v(1));        % v.real[(long)(1.0) - 1L]
disp(v(end));      % `end` resolves to v.rows * v.cols
disp(v(end - 1));

% Matrix indexing uses the column-major formula i + j*rows.
M = [1 2 3; 4 5 6];
disp(M(2, 3));     % M.real[(long)(2)-1L + ((long)(3)-1L) * M.rows]
disp(M(end, end)); % both ends resolve via .rows / .cols

% ── Range / colon reads ──────────────────────────────────────────────
% A range read allocates a fresh result tensor and fills it via a
% counted loop. Result orientation: `Range` preserves the base for
% vectors; `Colon` always linearizes to a column.
a = v(2:4);        % row vector of 3
b = v(:);          % column vector of 5 (linearized)
c = M(2:5);        % matrix linear-index → row vector of 4
disp(a);
disp(b);
disp(c);

% ── Scalar writes ────────────────────────────────────────────────────
% Indexed writes mutate the base buffer in place — no realloc, no
% mtoc_tensor_assign.
v(1) = 99;         % v.real[0] = 99.0;
v(end) = -1;       % v.real[v.rows * v.cols - 1] = -1.0;
disp(v);

% Matrix writes use the same column-major offset formula.
M(2, 2) = 0;
disp(M);

% ── Range / colon writes ─────────────────────────────────────────────
% A range write runs a per-slot loop. Tensor RHS adds a runtime count
% check (aborts on size mismatch); scalar RHS broadcasts.
patch = [100 200 300];
v(2:4) = patch;    % per-slot copy from patch
disp(v);
v(:) = 0;          % scalar broadcast across the whole vector
disp(v);

% ── A concrete use: cumulative sum ───────────────────────────────────
% Combines scalar writes inside a loop with a final disp.
running = [0 0 0 0 0];
total = 0;
for k = 1:5
  total = total + k;
  running(k) = total;
end
disp(running);
