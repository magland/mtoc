% Cross-runner coverage for isnan / isinf / isfinite / logical.
disp(isnan(0/0));
disp(isnan(1.5));
disp(isinf(1/0));
disp(isinf(-1/0));
disp(isinf(2));
disp(isfinite(3.14));
disp(isfinite(0/0));
disp(isfinite(1/0));
disp(logical(0));
disp(logical(1));
disp(logical(-7.5));
disp(logical(0/0));
