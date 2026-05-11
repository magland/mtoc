% Negative real base raised to a non-integer constant exponent lifts
% to complex (principal-value cpow). Integer exponents stay real.
disp((-1)^0.5);
disp((-4)^0.5);
disp((-8)^(1/3));
disp((-2)^1.5);
% Integer-exponent path: stays on real `pow`, no complex widening.
disp((-2)^2);
disp((-2)^3);
disp((-3)^0);
