% .^ and ^ propagate sign refinements that downstream domain checks
% (e.g. sqrt) can rely on without explicit `abs`.

% Real base (sign unknown) ^ constant positive even integer is nonneg.
function y = norm2(a, b)
  y = sqrt(a.^2 + b.^2);
end
disp(norm2(3, 4));
disp(norm2(-5, 12));

% Same for scalar `^`.
function y = norm2_scalar(a, b)
  y = sqrt(a^2 + b^2);
end
disp(norm2_scalar(7, 24));

% Strictly-positive base stays strictly positive across `.^` —
% the result feeds 1./sqrt without a domain-check failure.
function y = inv_root_pow(x)
  y = 1 ./ sqrt(x .^ 3);
end
disp(round(inv_root_pow(4) * 10000));

% Constant positive odd integer propagates the base sign:
% for a positive loop variable, k.^3 is still positive.
acc = 0;
for k = 1:4
  acc = acc + sqrt(k .^ 3);
end
disp(round(acc * 10000));
