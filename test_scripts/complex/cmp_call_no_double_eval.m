% Test: complex function-call result used as a comparison operand.
% Exercises the code path where a Call node appears directly as the
% operand of == / ~= / ~ rather than via an intermediate variable.
% The cross-runner verifies stdout matches numbl byte-for-byte.

z = -4 + 0i;
w = 0 + 2i;

% sqrt(-4+0i) = 0+2i  (principal square root)
disp(sqrt(z) == w);    % 1
disp(sqrt(z) ~= w);    % 0

% Unary ~ on a complex call result
disp(~(sqrt(z) == w)); % 0
disp(~(sqrt(z) ~= w)); % 1

% ~= with call on the right-hand side
disp(w ~= sqrt(z));    % 0
disp(w == sqrt(z));    % 1
