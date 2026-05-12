% Cross-runner coverage for complex inputs to isnan / isinf / isfinite.
% numbl semantics:
%   isnan(z)    true iff EITHER lane is NaN
%   isinf(z)    true iff EITHER lane is infinite
%   isfinite(z) true iff BOTH lanes are finite
% `logical` rejects complex in numbl, so we don't test it here.
disp(isnan(0 + 0i));
disp(isnan((0/0) + 0i));
disp(isnan(0 + (0/0)*1i));
disp(isnan((0/0) + (0/0)*1i));
disp(isnan(1 + 2i));

disp(isinf(0 + 0i));
disp(isinf((1/0) + 0i));
disp(isinf(0 + (1/0)*1i));
disp(isinf((-1/0) + 2i));
disp(isinf(1 + 2i));

disp(isfinite(0 + 0i));
disp(isfinite(3 + 4i));
disp(isfinite((1/0) + 2i));
disp(isfinite(3 + (0/0)*1i));
disp(isfinite((0/0) + (0/0)*1i));
