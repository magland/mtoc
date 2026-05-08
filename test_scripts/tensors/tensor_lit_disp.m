% Row-vector and matrix literals print the same way numbl does.
v = [1 2 3];
disp(v);

m = [1 2; 3 4];
disp(m);

big = [100 0.5 -3];
disp(big);

% Matrix with a fractional value to exercise non-integer formatting.
mix = [1.5 2.0; 3.0 4.5];
disp(mix);
