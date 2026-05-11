% Element-wise pow `.^` on tensor operands with scalar broadcast.

x = [1 2 3 4];

x2 = x .^ 2;
disp(x2);
x3 = x .^ 3;
disp(x3);

% Scalar base, tensor exponent
exps = [0 1 2 3];
p = 2 .^ exps;
disp(p);

% Two same-shape tensors
bases = [1 2 3 4];
ee = [4 3 2 1];
b = bases .^ ee;
disp(b);

% Column vector
cv = [1; 2; 3];
cv2 = cv .^ 2;
disp(cv2);
