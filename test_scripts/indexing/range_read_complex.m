% Complex tensor range / colon reads.
z = [1+2i, 3+4i, 5+6i, 7];
a = z(2:3); disp(a);
b = z(:); disp(b);
c = z(end:-1:1); disp(c);
% Complex column vector
zc = [1+2i; 3; 5+6i];
d = zc(2:3); disp(d);
e = zc(:); disp(e);
