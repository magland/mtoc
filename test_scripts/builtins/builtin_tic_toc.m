% Cross-runner coverage for `tic` / `toc`.
%
% The actual elapsed values are non-deterministic, so this script
% only prints derived predicates (`>= 0`, `< 10`) which are stable
% across runs and runtimes. The bare-statement `toc;` form prints
% an "Elapsed time is ..." line whose digits vary run-to-run, so we
% don't exercise that form here — it's checked manually.

% --- value-returning form (no parens, bare Ident at expr position) ---
t = tic;
disp(t > 0);
disp(t >= 0);

% --- value-returning form (parens) ---
t2 = tic();
disp(t2 > 0);

% --- bare `tic;` statement: side-effect only, no print ---
tic;
disp(1);

% --- `e = toc;` after tic ---
tic;
e = toc;
disp(e >= 0);
disp(e < 10);

% --- `e = toc()` parens form ---
tic;
e2 = toc();
disp(e2 >= 0);

% --- `toc(h)` handle form ---
h = tic;
eh = toc(h);
disp(eh >= 0);
disp(eh < 10);

% --- nested: `toc(tic)` ---
en = toc(tic);
disp(en >= 0);
disp(en < 1);
