% Elementwise arithmetic on 3-D tensors. Exercises scalar+tensor,
% unary minus, tensor.*tensor, tensor+tensor, and reassignment
% (target = target + 1).
v = [1 2 3 4 5 6 7 8 9 10 11 12];
A = reshape(v, 2, 3, 2);

P = A + 1;
disp(P);

Q = A * 2;
disp(Q);

R = -A;
disp(R);

% tensor .* tensor (source aliases target on read)
S = A .* A;
disp(S);

T = A + A;
disp(T);

% Reassignment through arithmetic: free old buffer, install new.
A = A + 1;
disp(A);
