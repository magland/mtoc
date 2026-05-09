% Range / colon writes on a vector.
v = [10 20 30 40 50];
patch = [99 98 97];
v(2:4) = patch;
disp(v);
% Colon write
all = [1 2 3 4 5];
v(:) = all;
disp(v);
% Scalar broadcast into a slice
v(2:4) = -1;
disp(v);
% Scalar broadcast into the whole vector
v(:) = 0;
disp(v);
% Stride
w = [10 20 30 40 50 60];
w(1:2:5) = 0;
disp(w);
% Reverse stride with a tensor RHS
backfill = [-1 -2 -3];
w(6:-1:4) = backfill;
disp(w);
% End in the slice bounds
v = [10 20 30 40 50];
tail = [-1 -2 -3];
v(end-2:end) = tail;
disp(v);
% Cumulative sum via slice writes in a loop.
running = [0 0 0 0 0];
total = 0;
for k = 1:5
  total = total + k;
  running(k) = total;
end
disp(running);
