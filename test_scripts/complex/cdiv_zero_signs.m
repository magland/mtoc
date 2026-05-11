% Exercise complex divide-by-zero signed-Inf path: when divisor is 0
% and numerator is non-zero, each part maps to signed Inf (positive,
% negative, or zero) rather than NaN.
disp((1 + 2i) / 0)
disp((-1 + 2i) / 0)
disp((1 - 2i) / 0)
disp((-1 - 2i) / 0)
