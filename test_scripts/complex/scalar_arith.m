% Scalar complex arithmetic — addition, subtraction, multiplication,
% division — including mixing complex and real operands so the
% real-promotes-to-complex path is exercised.
a = 1 + 2i;
b = 3 + 4i;

disp(a + b);
disp(a - b);
disp(a * b);
disp(a / b);

% Real ⊕ complex (both directions) and pure-imag arithmetic
disp(2 + a);
disp(a + 2);
disp(2 * a);
disp(a / 2);
disp(1i * 1i);

% Reassign through control flow
z = 1 + 1i;
z = z * (2 + 0i);
disp(z);
