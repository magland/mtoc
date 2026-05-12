% Cross-runner coverage for scalar `^` / `.^` with at least one
% complex operand. numbl routes these through C99's `cpow`; real
% operands are implicitly promoted to `double _Complex` at the call
% boundary.

% complex base, real integer exponent
z = 1 + 2i;
disp(z^2);
disp(z^3);
disp(z^0);

% complex base, real non-integer exponent
disp(z^0.5);

% real base, complex exponent
disp(2^(0 + 1i));
disp((-1)^(1i));

% complex base, complex exponent
w = 2 + 0.5i;
disp(z^w);

% .^ — same dispatch on scalars.
disp(z .^ 2);
disp(2 .^ z);
disp(z .^ w);
