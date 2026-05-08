disp(2 ^ 10);
disp(3 ^ 2);
disp(4 .^ 0.5);
disp(2 .^ -1);
disp((1 + 1) ^ 3);
disp(power(2, 8));

% Geometric mean — the body uses `abs` to assert nonneg for sqrt's static
% domain check, since the function is shared across all call-site signs.
disp(geom_mean(4, 9));

function y = geom_mean(a, b)
  y = sqrt(abs(a * b));
end
