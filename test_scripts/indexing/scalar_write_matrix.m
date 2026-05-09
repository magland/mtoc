% Scalar indexed writes on a matrix — column-major addressing.
M = [1 2 3; 4 5 6];
M(1,1) = 99;
M(2,3) = -7;
M(end,end) = 0;
M(1,end) = 42;
disp(M);
% Linear-index write into a matrix.
M(1) = 100;
M(end) = 200;
disp(M);
% Loop fill.
N = [0 0 0; 0 0 0; 0 0 0];
for i = 1:3
  for j = 1:3
    N(i, j) = (i - 1) * 3 + j;
  end
end
disp(N);
