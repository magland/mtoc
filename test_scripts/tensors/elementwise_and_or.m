% Elementwise `&` / `|` — the non-short-circuit logical operators.
% Both scalars and tensor operands are supported; the result is a
% 0/1 value of the broadcast shape, matching numbl's elementWiseLogicalOp.

% Scalar real
disp(1 & 1);
disp(1 & 0);
disp(0 & 0);
disp(1 | 1);
disp(0 | 1);
disp(0 | 0);

% Tensor & tensor (same shape)
a = [1 0 1 0];
b = [1 1 0 0];
disp(a & b);
disp(a | b);

% Tensor & scalar (broadcasts)
disp(a & 1);
disp(a | 0);
disp(0 & a);
disp(1 | b);

% Mixed with comparison ops: the usual "x > 0 and x < 1" idiom
x = [0.5 1.5 -0.5 0.25];
disp(x > 0 & x < 1);
disp(x < 0 | x > 1);

% Matrix
M = [1 0; 0 1];
N = [1 1; 1 0];
disp(M & N);
disp(M | N);

% Note: numbl's `&`/`|` runtime (`elementWiseLogicalOp`) does NOT do
% MATLAB-style implicit expansion — for differently-shaped same-numel
% tensor operands it linearly pairs and returns the first operand's
% shape (not a broadcast result). mtoc lifts the operator through the
% same broadcast emitter the comparisons use, which is the MATLAB
% specified behavior. Cross-runner-wise this means we skip the
% row + col case here; tracked upstream.

% Complex scalars: toBool both halves
z1 = 1 + 0i;
z2 = 0 + 1i;
z3 = 0 + 0i;
disp(z1 & z2);
disp(z1 | z3);
disp(z3 & z3);
