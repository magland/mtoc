% The log family accepts a `nonnegative` argument and matches numbl
% at exactly zero (-Inf for log/log2/log10; 0 for log1p(0)). The .^2
% sum-of-squares pattern produces a nonneg input without an `abs(...)`
% wrapper.
disp(log(0));
disp(log(0.0));
disp(log2(0));
disp(log10(0));
disp(log1p(0));

function val = neg_log_r2(rx, ry)
  r2 = rx.^2 + ry.^2;
  val = -log(r2);
end

% Same-shape row vectors; one column has rx==ry==0 so log(0) fires
% there and propagates as -Inf in both runners.
rx = [0 1 2 3];
ry = [0 0 1 4];
disp(neg_log_r2(rx, ry));
