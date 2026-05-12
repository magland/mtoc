% Cross-runner coverage for the complex rounding family — numbl
% applies floor / ceil / round / fix componentwise on complex.
disp(floor(3.7 + 2.3i));
disp(floor(-3.7 - 2.3i));
disp(floor(0 + 0i));

disp(ceil(3.2 + 2.8i));
disp(ceil(-3.2 - 2.8i));
disp(ceil(0 + 0i));

% MATLAB / numbl `round` is away-from-zero, so 2.5 → 3 and -2.5 → -3.
% C99 `round` matches.
disp(round(2.5 + 1.5i));
disp(round(-2.5 - 1.5i));
disp(round(3.5 + 2.5i));
disp(round(0 + 0i));

% `fix` truncates toward zero on each lane.
disp(fix(3.7 + 2.3i));
disp(fix(-3.7 - 2.3i));
disp(fix(3.7 - 2.3i));
disp(fix(0 + 0i));
