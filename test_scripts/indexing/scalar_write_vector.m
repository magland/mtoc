% Scalar indexed writes on a vector — base buffer is mutated in place.
v = [10 20 30 40 50];
v(2) = 99;
disp(v);
v(end) = -1;
disp(v);
v(end - 1) = 42;
disp(v);
i = 3;
v(i) = v(i) + 100;
disp(v);
% Several updates in a loop accumulate into the same buffer.
sq = [0 0 0 0 0];
for k = 1:5
  sq(k) = k * k;
end
disp(sq);
