% Cross-runner coverage for tensor `.^` with at least one complex
% operand. numbl applies cpow elementwise; the result is a complex
% tensor at the broadcast shape.

% complex row vec .^ scalar real (integer)
z = [1+2i, 3+4i, 0+1i];
disp(z .^ 2);

% scalar complex .^ real vec (scalar broadcasts)
w = 2 + 0.5i;
v = [0, 1, 2, 3];
disp(w .^ v);

% complex tensor .^ complex scalar
disp(z .^ (0 + 1i));

% real tensor .^ complex scalar
r = [1, 2, 3];
disp(r .^ (1 + 1i));
