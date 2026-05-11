% Elementwise arithmetic on a 3-D complex tensor.
v = [1+1i 2 3+2i 4 5 6+3i];
A = reshape(v, 1, 2, 3);
P = A + 1;
disp(P);
Q = A * 2;
disp(Q);
R = -A;
disp(R);
S = A + A;
disp(S);
