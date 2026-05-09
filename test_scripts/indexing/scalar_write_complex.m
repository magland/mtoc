% Scalar indexed writes on a complex tensor.
z = [1+2i, 3+4i, 5+6i];
% Complex into complex.
z(1) = 7+8i;
disp(z);
% Real into complex (numbl semantics: imag is reset to 0).
z(2) = 99;
disp(z);
% End-of-tensor write.
z(end) = -1 - 1i;
disp(z);
% Loop over a complex tensor.
w = [0+0i, 0+0i, 0+0i, 0+0i];
for k = 1:4
  w(k) = k + (k * 10) * 1i;
end
disp(w);
