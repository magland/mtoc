% sqrt of a real input whose static sign isn't statically nonneg
% promotes to the complex result type at codegen, matching numbl's
% runtime `realFn → NaN → complexFn` fallback.
%
% Scalar literals: sign is statically known to be negative — both
% runtimes produce a complex value with `re=0, im=sqrt(|x|)`.
disp(sqrt(-4));
disp(sqrt(-9));
disp(sqrt(-2));

% Scalar from a function whose output sign is unknown. mtoc commits to
% complex; numbl's runtime returns real when the actual value is
% nonneg. The format-side `im == 0 → real format` collapse in
% `mtoc_format_complex` keeps disp byte-for-byte identical.
function y = id(x)
  y = x;
end
disp(sqrt(id(4)));      % runtime nonneg → both print real
disp(sqrt(id(2)));
disp(sqrt(id(-4)));     % runtime negative → both print complex
disp(sqrt(id(-25)));

% Negate a known-positive value to get a known-negative sign.
function y = neg(x)
  y = -x;
end
disp(sqrt(neg(16)));    % sign refined to nonpositive at lowering
disp(sqrt(neg(49)));

% Tensors. The literal `[-1 4 -9 16]` has mixed sign → unknown;
% mtoc promotes to complex tensor. Per-cell `format_complex` collapses
% the nonneg cells back to the real format, so the printed columns
% match numbl's mixed-tensor output exactly.
disp(sqrt([-1 4 -9 16]));

% All-nonneg literal: sign is `positive`, sqrt stays real.
disp(sqrt([1 4 9 16]));

% Runtime-all-nonneg tensor via unknown-sign function. mtoc emits a
% complex tensor whose imag buffer is all-zero; the disp helper
% formats each cell via `format_complex`, which prints the real
% representation when im==0. Column widths match the real path.
function v = id_vec(w)
  v = w;
end
disp(sqrt(id_vec([1 4 9 16])));

% Mixed runtime sign through the same unknown-sign channel.
disp(sqrt(id_vec([-1 4 -9 16])));

% sqrt of a refined-negative scalar in a function — sign analysis
% sees the unary minus and flips positive → negative.
function r = sqrt_minus_sq(x)
  r = sqrt(-(x * x));
end
disp(sqrt_minus_sq(3));
disp(sqrt_minus_sq(7));
