% Cross-runner coverage for fprintf %f / %e / %g / %E / %G specs.
% numbl's sprintfFormat has specific rules — %d on non-integer falls
% back to %e prec=6, %g cuts off based on exponent vs precision, %e
% pads exponents to ≥2 digits.

fprintf('%f\n', 3.14159);
fprintf('%.2f\n', 3.14159);
fprintf('%10.4f\n', 3.14159);
fprintf('%e\n', 1000000);
fprintf('%E\n', 0.000005);
fprintf('%g\n', 1.5);
fprintf('%g\n', 1.5e-7);
fprintf('%g\n', 100000);
fprintf('%G\n', 1.5e-7);
fprintf('%.3g\n', 12345);

% %d on a non-integer: numbl falls back to %e prec=6.
fprintf('%d\n', 3.14);

% Multiple specs on one line.
fprintf('a=%d b=%f c=%g\n', 1, 2.5, 1.2345);
